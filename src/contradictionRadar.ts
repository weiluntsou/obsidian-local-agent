/**
 * contradictionRadar.ts — 即時矛盾檢測雷達 (Contradiction Radar)
 *
 * Feature 2 of the Second Self system.
 *
 * After a note is refined (and optionally after the Viewpoint Catalyst),
 * this module extracts the core arguments from the refined note, finds
 * semantically related personal opinion notes, and sends them along with
 * IDENTITY.md to the local LLM to detect logical contradictions.
 *
 * If contradictions are found, a high-visibility warning callout is
 * inserted at the top of the note body. If no conflicts exist, the
 * module operates silently.
 */

import { App, Notice, TFile, normalizePath } from "obsidian";
import { LocalLLMClient, parseJsonFromLLM } from "./api";

// ---------------------------------------------------------------------------
// System Prompt
// ---------------------------------------------------------------------------

const CONTRADICTION_DETECT_PROMPT = `你是一位嚴謹的邏輯審核員。你的職責是找出新筆記與使用者既有思維之間的矛盾。

你會收到三組輸入：
1. 【新筆記】：使用者剛精修的一篇筆記的核心論點。
2. 【既有觀點】：使用者過去寫下的相關筆記摘要（代表其過去的立場）。
3. 【身份描述】：使用者的 IDENTITY.md（記錄其核心價值觀與立場）。

你的任務：
- 比對新筆記的論點與既有觀點/身份描述，尋找以下類型的矛盾：
  1. 直接邏輯衝突（A 聲稱 X，B 聲稱 ¬X）
  2. 立場轉變（過去支持 X，現在暗示反對 X）
  3. 前提假設矛盾（兩篇筆記基於互相矛盾的假設）

嚴格輸出格式（JSON）：
{
  "hasContradiction": true/false,
  "contradictions": [
    {
      "conflictingNote": "與之矛盾的舊筆記名稱",
      "summary": "矛盾的簡短描述（一句話）",
      "type": "direct|shift|assumption"
    }
  ]
}

規則：
1. 若無矛盾，"hasContradiction" 為 false，"contradictions" 為空陣列。
2. 不要強行製造矛盾。只報告真正的邏輯衝突。
3. 「不同面向的補充」不算矛盾。
4. 使用繁體中文撰寫 summary。`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ContradictionResult {
  hasContradiction: boolean;
  contradictions: {
    conflictingNote: string;
    summary: string;
    type: "direct" | "shift" | "assumption";
  }[];
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class ContradictionRadar {
  constructor(
    private app: App,
    private apiClient: LocalLLMClient,
    private temperature: number,
    private secondSelfFolder: string,
    private identityFileName: string
  ) {}

  /**
   * Scan for contradictions between the refined note and existing
   * personal opinion notes + IDENTITY.md.
   *
   * @param file The refined note to check.
   * @returns Promise resolving when scan completes.
   */
  async scan(file: TFile): Promise<void> {
    try {
      const content = await this.app.vault.read(file);
      const body = this.stripFrontmatter(content);

      if (body.trim().length < 50) {
        return; // Too short to meaningfully check
      }

      // 1. Extract core arguments from refined note (use summary + highlights)
      const coreArguments = this.extractCoreArguments(body);
      if (!coreArguments) return;

      // 2. Find related personal opinion notes
      const relatedNotes = this.findRelatedOpinionNotes(file, 8);
      if (relatedNotes.length === 0) {
        console.log("[ContradictionRadar] No related opinion notes found.");
        return;
      }

      // 3. Read IDENTITY.md
      const identityContent = await this.readIdentityFile();

      // 4. Build context from related notes
      let existingOpinions = "";
      for (const related of relatedNotes) {
        const relContent = await this.app.vault.read(related);
        const relBody = this.stripFrontmatter(relContent);
        // Limit each note to avoid token overflow
        existingOpinions += `\n--- 筆記：[[${related.basename}]] ---\n${relBody.substring(0, 500)}\n`;
      }

      // 5. Send to LLM for contradiction detection
      const userPrompt = [
        `【新筆記】標題：${file.basename}`,
        `核心論點：\n${coreArguments}\n`,
        `【既有觀點】\n${existingOpinions}\n`,
        identityContent
          ? `【身份描述 IDENTITY.md】\n${identityContent}\n`
          : "",
      ].join("\n");

      const rawResponse = await this.apiClient.prompt(
        CONTRADICTION_DETECT_PROMPT,
        userPrompt,
        this.temperature
      );

      const parsed = parseJsonFromLLM<ContradictionResult>(rawResponse);

      if (!parsed || typeof parsed.hasContradiction !== "boolean") {
        console.error(
          "[ContradictionRadar] Invalid LLM response:",
          rawResponse
        );
        return;
      }

      // 6. If contradictions found, inject warning callout
      if (
        parsed.hasContradiction &&
        parsed.contradictions &&
        parsed.contradictions.length > 0
      ) {
        await this.injectContradictionWarning(file, parsed.contradictions);
        new Notice(
          `⚠️ 在「${file.basename}」中發現 ${parsed.contradictions.length} 個思維衝突！`
        );
      } else {
        console.log(
          `[ContradictionRadar] No contradictions found for ${file.basename}.`
        );
      }
    } catch (err) {
      console.error("[ContradictionRadar] Error:", err);
      // Fail silently — contradiction detection is non-blocking
    }
  }

  /**
   * Extract core arguments from the note body.
   * Looks for summary callout and highlights section.
   */
  private extractCoreArguments(body: string): string | null {
    const parts: string[] = [];

    // Extract summary from callout
    const summaryMatch = body.match(
      />\s*\[!summary\][^\n]*\n((?:>\s*.*\n?)*)/i
    );
    if (summaryMatch) {
      parts.push(
        summaryMatch[1]
          .split("\n")
          .map((l) => l.replace(/^>\s*/, ""))
          .join("\n")
          .trim()
      );
    }

    // Extract highlights section
    const highlightsMatch = body.match(
      /## 重點提取\n([\s\S]*?)(?=\n## |$)/
    );
    if (highlightsMatch) {
      parts.push(highlightsMatch[1].trim());
    }

    // Extract personal reflection if it exists
    const reflectionMatch = body.match(
      />\s*\[!reflection\][^\n]*\n((?:>\s*.*\n?)*)/i
    );
    if (reflectionMatch) {
      parts.push(
        reflectionMatch[1]
          .split("\n")
          .map((l) => l.replace(/^>\s*/, ""))
          .join("\n")
          .trim()
      );
    }

    if (parts.length === 0) {
      // Fallback: just use the first 1000 chars
      return body.substring(0, 1000);
    }

    return parts.join("\n\n");
  }

  /**
   * Find personal opinion notes (not reference/atomic-note types)
   * that are semantically related to the current note via tags.
   */
  private findRelatedOpinionNotes(
    currentFile: TFile,
    limit: number
  ): TFile[] {
    const currentTags = this.getFileTags(currentFile).map((t) =>
      t.toLowerCase()
    );
    const allFiles = this.app.vault.getMarkdownFiles();
    const candidates: { file: TFile; score: number }[] = [];

    for (const f of allFiles) {
      if (f.path === currentFile.path) continue;

      // Skip reference and atomic notes — we want personal opinions
      const cache = this.app.metadataCache.getFileCache(f);
      const fmType = cache?.frontmatter?.type;
      if (
        fmType === "reference" ||
        fmType === "atomic-note" ||
        fmType === "insight-report" ||
        fmType === "plan" ||
        fmType === "draft" ||
        fmType === "identity"
      ) {
        continue;
      }

      // Skip system files
      if (
        f.basename.includes("Atomic Note") ||
        f.basename === "plan" ||
        f.basename === "draft"
      ) {
        continue;
      }

      let score = 0;
      const fTags = this.getFileTags(f).map((t) => t.toLowerCase());

      for (const tag of fTags) {
        if (currentTags.includes(tag)) {
          score += 10;
        }
      }

      // Boost recently modified notes
      const daysSinceModified =
        (Date.now() - f.stat.mtime) / (1000 * 60 * 60 * 24);
      if (daysSinceModified < 30) {
        score += 3;
      }

      if (score > 0) {
        candidates.push({ file: f, score });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, limit).map((c) => c.file);
  }

  /**
   * Read the IDENTITY.md file content.
   */
  private async readIdentityFile(): Promise<string | null> {
    const identityPath = normalizePath(
      `${this.secondSelfFolder}/${this.identityFileName}`
    );
    const identityFile =
      this.app.vault.getAbstractFileByPath(identityPath);

    if (!identityFile || !(identityFile instanceof TFile)) {
      return null;
    }

    const content = await this.app.vault.read(identityFile as TFile);
    return this.stripFrontmatter(content);
  }

  /**
   * Inject a contradiction warning callout at the top of the note body
   * (after frontmatter).
   */
  private async injectContradictionWarning(
    file: TFile,
    contradictions: ContradictionResult["contradictions"]
  ): Promise<void> {
    const content = await this.app.vault.read(file);
    const fmMatch = content.match(/^---\s*\n[\s\S]*?\n---\s*\n?/);
    const frontmatterStr = fmMatch ? fmMatch[0] : "";
    const bodyStr = content.substring(frontmatterStr.length);

    // Remove existing contradiction warnings to avoid stacking
    const cleanBody = bodyStr.replace(
      /> \[!warning\] 思維衝突警告[\s\S]*?(?=\n[^>]|\n$|$)/g,
      ""
    ).trimStart();

    // Build warning callout
    const typeLabels: Record<string, string> = {
      direct: "直接衝突",
      shift: "立場轉變",
      assumption: "前提矛盾",
    };

    const warningLines = [
      `> [!warning] 思維衝突警告 (Contradiction Flag)`,
    ];

    for (const c of contradictions) {
      const typeLabel = typeLabels[c.type] || c.type;
      warningLines.push(
        `> - **[${typeLabel}]** 與 [[${c.conflictingNote}]]：${c.summary}`
      );
    }

    warningLines.push("");

    const newContent =
      frontmatterStr + warningLines.join("\n") + "\n" + cleanBody;
    await this.app.vault.modify(file, newContent);
  }

  // ---- Helpers ----------------------------------------------------------

  private getFileTags(file: TFile): string[] {
    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache) return [];

    const tags: string[] = [];

    if (cache.frontmatter) {
      const fmTags = cache.frontmatter.tags || cache.frontmatter.tag;
      if (Array.isArray(fmTags)) {
        for (const t of fmTags) {
          if (typeof t === "string") {
            tags.push(t.replace(/^#/, "").trim());
          }
        }
      } else if (typeof fmTags === "string") {
        const parts = fmTags
          .split(/[\s,]+/)
          .map((p) => p.replace(/[\[\]"']|#/g, "").trim());
        tags.push(...parts.filter(Boolean));
      }
    }

    if (cache.tags) {
      for (const t of cache.tags) {
        tags.push(t.tag.replace(/^#/, "").trim());
      }
    }

    return Array.from(new Set(tags));
  }

  private stripFrontmatter(content: string): string {
    const fmRegex = /^---\s*\n[\s\S]*?\n---\s*\n?/;
    return content.replace(fmRegex, "").trim();
  }
}
